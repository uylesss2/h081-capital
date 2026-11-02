// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract GrantVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 8127552621136733191734693880717856597362278905596170938803746160239241524032;
    uint256 constant deltax2 = 21886958229581032682973445855205151990564418181422632021171832348772422861638;
    uint256 constant deltay1 = 20160638827454569489471153038677593292255252212357229363049572819437743098320;
    uint256 constant deltay2 = 9973504917636039362109036019336535336704462696064245035444198382039754580448;

    
    uint256 constant IC0x = 17456782598192307023955676605817654252863062194920675674018736026764241865292;
    uint256 constant IC0y = 6018913876159530265626929846982005963622106056983050177687602136710890207551;
    
    uint256 constant IC1x = 15826619988440733099763073405838057186818265628684694019124536759751259865521;
    uint256 constant IC1y = 12696638268015472167516341116470479980489352000926620719836463099958502339258;
    
    uint256 constant IC2x = 13707354400678210055587270205108655430939350381264426783820721689598948535768;
    uint256 constant IC2y = 17177718384097680925969633469348973100268071043679631187862955951311842322274;
    
    uint256 constant IC3x = 20813103561156614054432341823985137904663303661150727788551225807039082668381;
    uint256 constant IC3y = 10608579523374648393003156945891253509005686337846207004425117928361961933470;
    
    uint256 constant IC4x = 6715160009270967792059827882542959962936608853179267060072083105517132750759;
    uint256 constant IC4y = 9685913822759399788194006806169543855085731169233800061375145129626918055906;
    
    uint256 constant IC5x = 21272808897018700943731795006812350829062132528342459698582662875065590800932;
    uint256 constant IC5y = 17745258813959205482301311259165744181056994780623051421324038637131568110519;
    
    uint256 constant IC6x = 17084812384337968888576886167719558778819377542223389197002211526858766583197;
    uint256 constant IC6y = 5444423203941259338701896325870158137998134399703433701175921186312959630911;
    
    uint256 constant IC7x = 1577683665082558967992369814932409109486979964771813480613585522314456315157;
    uint256 constant IC7y = 16877773880304982360893764738753289063957476357362199309645497742324468776851;
    
    uint256 constant IC8x = 13613938993227334341009442640874438125712138337011440301987463840567885616905;
    uint256 constant IC8y = 12185480355389632022332851094929551515218415341818023236543976142970524376361;
    
    uint256 constant IC9x = 4230324056171980675979426200558141830496839785473855568623196165743833235672;
    uint256 constant IC9y = 19199060395445682312930151678127149851486788486836581274149284184289506608838;
    
    uint256 constant IC10x = 2999378088309632679625072706369785487043663492546917315378519593957931053176;
    uint256 constant IC10y = 10919515083814134734211682741299032631201281588070626381141423036722010977854;
    
    uint256 constant IC11x = 9049721140631615482263809308846814265178333914311555595296460110662347619016;
    uint256 constant IC11y = 10410026813192883350197319731541635408381509743660199381098050006818777202554;
    
    uint256 constant IC12x = 10926450144328367382440338361768798790460416716171080030361977610457400999782;
    uint256 constant IC12y = 10292117375874936042351743129542755604474955014891178228750752523189957210435;
    
    uint256 constant IC13x = 9334419207014036090252885801973148296554637918982104055885331167174356281160;
    uint256 constant IC13y = 8668111473542889667657775303444379371953453798192490504108779593919017108801;
    
    uint256 constant IC14x = 6525084188192907587608813419615308571137264327437282292435717367200687259951;
    uint256 constant IC14y = 9737519606530960544817775224679284700123579630153215491299164841554719757067;
    
    uint256 constant IC15x = 11871196607019120220802308973764463332442908442173130326421524278781400379504;
    uint256 constant IC15y = 15642070212782534973852357798570977464573244391170079993188972913755148185258;
    
    uint256 constant IC16x = 20602169026754859856979834560110325159944353835409519846602535494964994796501;
    uint256 constant IC16y = 14467806478285370032249322719182166796305493725992370535569234308195508407368;
    
    uint256 constant IC17x = 14223889893084832360304955860282922008441033462463611885239681772107669675960;
    uint256 constant IC17y = 10472790503401749613154066527459184893385397437364446243171372449925407852409;
    
    uint256 constant IC18x = 8074093893983956435898335191941340086414671270368450524732053115702620523820;
    uint256 constant IC18y = 19057130997750084500746646818486840590030640177181403445722449795326162741928;
    
    uint256 constant IC19x = 21586703001619937864929758202090455020125491569535673720913131470876139076413;
    uint256 constant IC19y = 14124094569460780926224943825677755475950083211358398366619014099813519650851;
    
    uint256 constant IC20x = 884563559181212376146517247529126886385390936803891815766764163049865125186;
    uint256 constant IC20y = 11303872829344051394929946041980742193313659929547352498704468927128388699928;
    
    uint256 constant IC21x = 21698790851557017359711396848203253694847900457899499840156555895260087228018;
    uint256 constant IC21y = 20334181154994255839896583732747797882260739445927106500960472030556549376683;
    
    uint256 constant IC22x = 7519819415128532171897329984006411807882197924762090407889166432317544873367;
    uint256 constant IC22y = 13156270434950102047941281666851872774560999221908179510110034156527868393548;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[22] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
